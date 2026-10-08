[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$TransactionSelfTest,
  [string]$CertificateThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT,
  [string]$TimestampServer = "http://timestamp.digicert.com",
  [string]$SignToolPath = $env:JARVIS_SIGNTOOL_PATH,
  [int]$MinimumDaysValid = 30
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
$reportPath = Join-Path $workspaceRoot "dist\windows-code-signing-release.json"
$pcPackageRoot = Join-Path $workspaceRoot "dist\pc-agent-installer"
$corePackageRoot = Join-Path $workspaceRoot "dist\core-service-package"
$coreServiceHost = Join-Path $corePackageRoot "JarvisCoreRuntimeHost.exe"
$corePackageCli = Join-Path $workspaceRoot "scripts\core-service-package.mjs"
$pcPackageCli = Join-Path $workspaceRoot "apps\pc-agent\src\cli\package-installer.mjs"
$independentAuditScript = Join-Path $workspaceRoot "scripts\windows-code-signing-audit.mjs"
$prerequisites = @(
  [pscustomobject]@{ id = "core-package-generator"; path = $corePackageCli },
  [pscustomobject]@{ id = "pc-agent-package-generator"; path = $pcPackageCli },
  [pscustomobject]@{ id = "independent-signing-audit"; path = $independentAuditScript }
)
$auditTargets = @(
  [pscustomobject]@{ id = "core-service-host"; path = $coreServiceHost },
  [pscustomobject]@{ id = "pc-agent-tray"; path = (Join-Path $pcPackageRoot "JarvisPcAgentTray.exe") },
  [pscustomobject]@{ id = "pc-agent-service-host"; path = (Join-Path $pcPackageRoot "JarvisPcAgentServiceHost.exe") },
  [pscustomobject]@{ id = "pc-agent-runtime-integrity"; path = (Join-Path $pcPackageRoot "runtime-integrity.psd1") },
  [pscustomobject]@{ id = "pc-agent-installer"; path = (Join-Path $pcPackageRoot "JARVIS-PC-Agent-Setup.exe") }
)

function Write-SafeReport([string]$Status, [array]$Checks, [array]$Artifacts) {
  $parent = Split-Path -Parent $reportPath
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $report = [pscustomobject]@{
    reportVersion = "jarvis-windows-code-signing-release-v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = $Status
    executeRequested = [bool]$Execute
    checks = @($Checks)
    artifacts = @($Artifacts)
    privacy = [pscustomobject]@{
      certificateThumbprintStored = $false
      certificateSubjectStored = $false
      privateKeyMaterialStored = $false
      artifactPathsStored = $false
    }
  } | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($reportPath, $report + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Wrote $reportPath"
}

function Add-Check([System.Collections.ArrayList]$Checks, [string]$Id, [bool]$Passed, [hashtable]$Detail = @{}) {
  [void]$Checks.Add([pscustomobject]@{ id = $Id; passed = $Passed; detail = $Detail })
}

function Resolve-SignTool([string]$ConfiguredPath) {
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
    try { $resolved = [IO.Path]::GetFullPath($ConfiguredPath) } catch { return $null }
    if (Test-Path -LiteralPath $resolved -PathType Leaf) { return $resolved }
    return $null
  }
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
  if ($candidates.Count -gt 0) { return $candidates[0].FullName }
  return $null
}

function Resolve-CSharpCompiler {
  return @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Resolve-NsisCompiler {
  $command = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return @(
    (Join-Path $env:ProgramFiles "NSIS\makensis.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Invoke-AtomicFileReplacement([string]$Source, [string]$Destination, [string]$TransactionId) {
  $incoming = "$Destination.jarvis-incoming-$TransactionId"
  $replacementBackup = "$Destination.jarvis-replaced-$TransactionId"
  $destinationParent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }
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

function Remove-PromotedDestination([string]$Path) {
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $allowedRoots = @($corePackageRoot, $pcPackageRoot) | ForEach-Object {
    [IO.Path]::GetFullPath($_).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  }
  if (-not @($allowedRoots | Where-Object { $resolvedPath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count) {
    throw "승격 롤백 경로가 허용된 출시 디렉터리를 벗어났습니다."
  }
  Remove-Item -LiteralPath $resolvedPath -Force -ErrorAction SilentlyContinue
}

if ($TransactionSelfTest) {
  $selfTestId = [guid]::NewGuid().ToString("N")
  $selfTestRoot = Join-Path ([IO.Path]::GetTempPath()) "jarvis-signing-transaction-selftest-$selfTestId"
  $selfTestPromotions = New-Object System.Collections.ArrayList
  $restoredCount = 0
  $removedCreatedCount = 0
  $failureType = $null
  $failureMessage = $null
  try {
    New-Item -ItemType Directory -Path $selfTestRoot -Force | Out-Null
    foreach ($index in 1..5) {
      $destination = Join-Path $selfTestRoot "artifact-$index.bin"
      $source = Join-Path $selfTestRoot "artifact-$index.signed"
      $backup = Join-Path $selfTestRoot "artifact-$index.original"
      $destinationExisted = $index -ne 2
      if ($destinationExisted) {
        [IO.File]::WriteAllText($destination, "original-$index", (New-Object Text.UTF8Encoding($false)))
        Copy-Item -LiteralPath $destination -Destination $backup -Force
      }
      [IO.File]::WriteAllText($source, "signed-$index", (New-Object Text.UTF8Encoding($false)))
      [void]$selfTestPromotions.Add([pscustomobject]@{ source = $source; destination = $destination; backup = $backup; destinationExisted = $destinationExisted })
    }
    $promotedCount = 0
    try {
      foreach ($promotion in $selfTestPromotions) {
        if ($promotedCount -eq 3) { throw "simulated-promotion-failure" }
        Invoke-AtomicFileReplacement $promotion.source $promotion.destination $selfTestId
        $promotedCount += 1
      }
    } catch {
      $failureType = $_.Exception.GetBaseException().GetType().Name
      $failureMessage = $_.Exception.GetBaseException().Message -replace [regex]::Escape($selfTestRoot), "<temp>"
      foreach ($promotion in @($selfTestPromotions | Select-Object -First $promotedCount)) {
        if ($promotion.destinationExisted) {
          Invoke-AtomicFileReplacement $promotion.backup $promotion.destination "selftest-rollback-$selfTestId"
        } else {
          $resolvedDestination = [IO.Path]::GetFullPath($promotion.destination)
          $resolvedSelfTestRoot = [IO.Path]::GetFullPath($selfTestRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
          if (-not $resolvedDestination.StartsWith($resolvedSelfTestRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "self-test rollback path escaped its root" }
          Remove-Item -LiteralPath $resolvedDestination -Force -ErrorAction SilentlyContinue
          $removedCreatedCount += 1
        }
        $restoredCount += 1
      }
    }
    $restoredExactly = $true
    foreach ($index in 1..5) {
      $destination = Join-Path $selfTestRoot "artifact-$index.bin"
      if ($index -eq 2) {
        if (Test-Path -LiteralPath $destination) { $restoredExactly = $false }
      } elseif ([IO.File]::ReadAllText($destination) -ne "original-$index") {
        $restoredExactly = $false
      }
    }
    [pscustomobject]@{
      status = if ($promotedCount -eq 3 -and $restoredCount -eq 3 -and $restoredExactly) { "passed" } else { "failed" }
      artifactCount = 5
      promotedBeforeFailure = $promotedCount
      restoredCount = $restoredCount
      restoredExactly = $restoredExactly
      originallyMissingCount = 1
      removedCreatedCount = $removedCreatedCount
      failureType = $failureType
      failureMessage = $failureMessage
    } | ConvertTo-Json -Compress
    if (-not $restoredExactly -or $restoredCount -ne 3) { exit 1 }
    exit 0
  } finally {
    try {
      $resolvedSelfTestRoot = [IO.Path]::GetFullPath($selfTestRoot)
      $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
      if ($resolvedSelfTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedSelfTestRoot).StartsWith("jarvis-signing-transaction-selftest-")) {
        Remove-Item -LiteralPath $resolvedSelfTestRoot -Recurse -Force -ErrorAction SilentlyContinue
      }
    } catch { }
  }
}

$checks = New-Object System.Collections.ArrayList
$artifactResults = New-Object System.Collections.ArrayList

$resolvedSignTool = Resolve-SignTool $SignToolPath
Add-Check $checks "windows-sdk-signtool-available" ($null -ne $resolvedSignTool) @{ configured = -not [string]::IsNullOrWhiteSpace($SignToolPath) }

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$resolvedNode = if ($nodeCommand) { $nodeCommand.Source } else { $null }
Add-Check $checks "node-package-runtime-available" ($null -ne $resolvedNode)

$resolvedCsc = Resolve-CSharpCompiler
Add-Check $checks "windows-csharp-compiler-available" ($null -ne $resolvedCsc)

$resolvedNsis = Resolve-NsisCompiler
Add-Check $checks "nsis-installer-compiler-available" ($null -ne $resolvedNsis)

$missing = @($prerequisites | Where-Object { -not (Test-Path -LiteralPath $_.path -PathType Leaf) })
Add-Check $checks "release-signing-prerequisites-present" ($missing.Count -eq 0) @{ expected = $prerequisites.Count; present = $prerequisites.Count - $missing.Count }

$timestampServerValid = $false
try {
  $timestampUri = [Uri]$TimestampServer
  $timestampServerValid = $timestampUri.IsAbsoluteUri -and @("http", "https") -contains $timestampUri.Scheme
} catch {
  $timestampServerValid = $false
}
Add-Check $checks "trusted-timestamp-server-configured" $timestampServerValid

$certificate = $null
$certificateStoreLocation = $null
if (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
  $normalizedThumbprint = $CertificateThumbprint.Replace(" ", "").ToUpperInvariant()
  foreach ($storeLocation in @("CurrentUser", "LocalMachine")) {
    $storePath = if ($storeLocation -eq "LocalMachine") { "Cert:\LocalMachine\My" } else { "Cert:\CurrentUser\My" }
    $candidate = Get-ChildItem -Path $storePath -ErrorAction SilentlyContinue |
      Where-Object { $_.Thumbprint -eq $normalizedThumbprint } |
      Select-Object -First 1
    if ($candidate) {
      $certificate = $candidate
      $certificateStoreLocation = $storeLocation
      break
    }
  }
}
Add-Check $checks "production-certificate-configured" (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint))
Add-Check $checks "production-certificate-found" ($null -ne $certificate)

if ($certificate) {
  $selfSigned = $certificate.Subject -eq $certificate.Issuer
  $ekuOids = @($certificate.EnhancedKeyUsageList | ForEach-Object {
    if ($_.ObjectId -is [string]) { [string]$_.ObjectId }
    elseif ($_.ObjectId.Value) { [string]$_.ObjectId.Value }
    else { [string]$_.ObjectId }
  })
  $hasCodeSigningEku = $ekuOids -contains "1.3.6.1.5.5.7.3.3"
  $daysValid = [Math]::Floor(($certificate.NotAfter.ToUniversalTime() - (Get-Date).ToUniversalTime()).TotalDays)
  $keyAlgorithmOid = $certificate.PublicKey.Oid.Value
  $keySize = try { [int]$certificate.PublicKey.Key.KeySize } catch { 0 }
  $supportedKey = $keyAlgorithmOid -eq "1.2.840.113549.1.1.1" -and $keySize -ge 2048 -and $keySize -le 4096
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
    $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    $chainTrusted = $chain.Build($certificate)
  } finally {
    $chain.Dispose()
  }
  Add-Check $checks "production-certificate-not-self-signed" (-not $selfSigned)
  Add-Check $checks "production-certificate-has-private-key" $certificate.HasPrivateKey
  Add-Check $checks "production-certificate-code-signing-eku" $hasCodeSigningEku
  Add-Check $checks "production-certificate-key-policy" $supportedKey @{ algorithm = $(if ($keyAlgorithmOid -eq "1.2.840.113549.1.1.1") { "RSA" } else { "unsupported" }); keySize = $keySize; minimumRsaKeySize = 2048; maximumRsaKeySize = 4096 }
  Add-Check $checks "production-certificate-validity-window" ($daysValid -ge $MinimumDaysValid) @{ daysValid = $daysValid; minimumDaysValid = $MinimumDaysValid }
  Add-Check $checks "production-certificate-chain-trusted" $chainTrusted @{ revocationMode = "Online" }
}

$prerequisitesPassed = $missing.Count -eq 0 -and $checks.Count -gt 0 -and @($checks | Where-Object { -not $_.passed }).Count -eq 0
if (-not $Execute) {
  $preflightStatus = if ($prerequisitesPassed) { "ready-to-sign" } else { "blocked" }
  Write-SafeReport $preflightStatus $checks $artifactResults
  if ($prerequisitesPassed) {
    Write-Host "Windows production signing preflight passed. Re-run with -Execute to sign release artifacts."
    exit 0
  }
  Write-Host "Windows production signing preflight is blocked. No executable was modified."
  exit 2
}

if (-not $prerequisitesPassed) {
  Write-SafeReport "blocked" $checks $artifactResults
  throw "Windows production signing prerequisites are not satisfied. See dist/windows-code-signing-release.json."
}

$transactionId = [guid]::NewGuid().ToString("N")
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) "jarvis-release-signing-$transactionId"
$stagePcRoot = Join-Path $stageRoot "pc-agent-installer"
$stageCoreRoot = Join-Path $stageRoot "core-service-package"
$stageCoreHost = Join-Path $stageCoreRoot "JarvisCoreRuntimeHost.exe"
$backupRoot = Join-Path $stageRoot "original-backup"
$promotions = New-Object System.Collections.ArrayList
$promotionStarted = $false
$promotedCount = 0
$rollbackSucceeded = $true

try {
  New-Item -ItemType Directory -Path $stagePcRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $stageCoreRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

  & $resolvedNode $corePackageCli --output $stageCoreRoot
  if ($LASTEXITCODE -ne 0) { throw "Core Runtime 소스 패키지 생성에 실패했습니다. 종료 코드: $LASTEXITCODE" }
  & $resolvedNode $pcPackageCli --output $pcPackageRoot --write-output $stagePcRoot
  if ($LASTEXITCODE -ne 0) { throw "PC Agent 소스 패키지 생성에 실패했습니다. 종료 코드: $LASTEXITCODE" }

  $stageCoreVerifyScript = Join-Path $stageCoreRoot "verify-package.ps1"
  $stageCoreBuildScript = Join-Path $stageCoreRoot "build-service-host.ps1"
  & $stageCoreVerifyScript
  & $stageCoreBuildScript

  $stagePcVerifyScript = Join-Path $stagePcRoot "verify-package.ps1"
  $stagePcTrayBuildScript = Join-Path $stagePcRoot "build-tray-exe.ps1"
  $stagePcServiceBuildScript = Join-Path $stagePcRoot "build-service-host.ps1"
  & $stagePcVerifyScript -SourceOnly
  & $stagePcTrayBuildScript
  & $stagePcServiceBuildScript

  $coreSignArguments = @("sign", "/q", "/fd", "SHA256", "/sha1", $normalizedThumbprint, "/s", "My", "/d", "JARVIS Core Runtime")
  if ($certificateStoreLocation -eq "LocalMachine") { $coreSignArguments += "/sm" }
  $coreSignArguments += @("/tr", $TimestampServer, "/td", "SHA256", $stageCoreHost)
  & $resolvedSignTool @coreSignArguments
  if ($LASTEXITCODE -ne 0) { throw "Core Runtime RFC 3161 서명에 실패했습니다. 종료 코드: $LASTEXITCODE" }

  $stagePcSignScript = Join-Path $stagePcRoot "sign-artifacts.ps1"
  $stagePcBuildInstallerScript = Join-Path $stagePcRoot "build-nsis-installer.ps1"
  & $stagePcSignScript -CertificateThumbprint $normalizedThumbprint -TimestampServer $TimestampServer -SignToolPath $resolvedSignTool -CertificateStoreLocation $certificateStoreLocation -RuntimeOnly -RequireTimestamp
  Push-Location $stagePcRoot
  try {
    & $stagePcBuildInstallerScript
  } finally {
    Pop-Location
  }
  & $stagePcSignScript -CertificateThumbprint $normalizedThumbprint -TimestampServer $TimestampServer -SignToolPath $resolvedSignTool -CertificateStoreLocation $certificateStoreLocation -SetupOnly -RequireTimestamp

  $stagedTargets = @(
    [pscustomobject]@{ id = "core-service-host"; source = $stageCoreHost; destination = $coreServiceHost },
    [pscustomobject]@{ id = "pc-agent-tray"; source = (Join-Path $stagePcRoot "JarvisPcAgentTray.exe"); destination = (Join-Path $pcPackageRoot "JarvisPcAgentTray.exe") },
    [pscustomobject]@{ id = "pc-agent-service-host"; source = (Join-Path $stagePcRoot "JarvisPcAgentServiceHost.exe"); destination = (Join-Path $pcPackageRoot "JarvisPcAgentServiceHost.exe") },
    [pscustomobject]@{ id = "pc-agent-runtime-integrity"; source = (Join-Path $stagePcRoot "runtime-integrity.psd1"); destination = (Join-Path $pcPackageRoot "runtime-integrity.psd1") },
    [pscustomobject]@{ id = "pc-agent-installer"; source = (Join-Path $stagePcRoot "JARVIS-PC-Agent-Setup.exe"); destination = (Join-Path $pcPackageRoot "JARVIS-PC-Agent-Setup.exe") }
  )

  foreach ($target in $stagedTargets) {
    if (-not (Test-Path -LiteralPath $target.source -PathType Leaf)) { throw "스테이징 산출물이 없습니다: $($target.id)" }
    $verified = Get-AuthenticodeSignature -LiteralPath $target.source
    $sameSigner = $null -ne $verified.SignerCertificate -and $verified.SignerCertificate.Thumbprint -eq $normalizedThumbprint
    if ($verified.Status -ne "Valid" -or $null -eq $verified.TimeStamperCertificate -or -not $sameSigner) {
      throw "스테이징 서명 검증에 실패했습니다: $($target.id)"
    }
  }

  $stagePackageManifest = Get-Content -LiteralPath (Join-Path $stagePcRoot "package-manifest.json") -Raw | ConvertFrom-Json
  $sourcePackageTargets = @($stagePackageManifest.files | ForEach-Object {
    [pscustomobject]@{
      id = "pc-agent-source-$($_)"
      source = Join-Path $stagePcRoot ([string]$_)
      destination = Join-Path $pcPackageRoot ([string]$_)
    }
  })
  $invalidatedReportNames = @(
    "signature-verification-report.json",
    "production-signing-report.json",
    "release-gate-report.json",
    "release-evidence.json",
    "install-release-report.json"
  )
  $invalidatedReportRoot = Join-Path $stageRoot "invalidated-release-reports"
  New-Item -ItemType Directory -Path $invalidatedReportRoot -Force | Out-Null
  $invalidatedReportTargets = @($invalidatedReportNames | ForEach-Object {
    $name = [string]$_
    $markerPath = Join-Path $invalidatedReportRoot $name
    $marker = [pscustomobject]@{
      reportVersion = "jarvis-release-evidence-invalidated-v1"
      generatedAt = (Get-Date).ToUniversalTime().ToString("o")
      status = "stale"
      reason = "code-signing-artifacts-updated"
      regenerationRequired = $true
      rawSecretsIncluded = $false
      certificateThumbprintsIncluded = $false
    } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($markerPath, $marker + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    [pscustomobject]@{ id = "pc-agent-invalidated-$name"; source = $markerPath; destination = (Join-Path $pcPackageRoot $name) }
  })
  $promotionCandidates = @(
    [pscustomobject]@{ id = "core-service-host"; source = $stageCoreHost; destination = $coreServiceHost }
  ) + $sourcePackageTargets + @($stagedTargets | Where-Object { $_.id -ne "core-service-host" }) + @(
    [pscustomobject]@{ id = "pc-agent-signature-report"; source = (Join-Path $stagePcRoot "signature-report.json"); destination = (Join-Path $pcPackageRoot "signature-report.json") }
  ) + $invalidatedReportTargets

  $promotionIndex = 0
  foreach ($target in $promotionCandidates) {
    if (-not (Test-Path -LiteralPath $target.source -PathType Leaf)) { throw "승격할 스테이징 파일이 없습니다: $($target.id)" }
    $destinationExisted = Test-Path -LiteralPath $target.destination -PathType Leaf
    $backupPath = if ($destinationExisted) { Join-Path $backupRoot ("artifact-{0:D3}.original" -f $promotionIndex) } else { $null }
    if ($destinationExisted) { Copy-Item -LiteralPath $target.destination -Destination $backupPath -Force }
    [void]$promotions.Add([pscustomobject]@{
      id = $target.id
      source = $target.source
      destination = $target.destination
      backup = $backupPath
      destinationExisted = [bool]$destinationExisted
    })
    $promotionIndex += 1
  }

  $promotionStarted = $true
  foreach ($promotion in $promotions) {
    Invoke-AtomicFileReplacement $promotion.source $promotion.destination $transactionId
    $promotedCount += 1
  }

  & (Join-Path $pcPackageRoot "verify-package.ps1")

  foreach ($target in $auditTargets) {
    $verified = Get-AuthenticodeSignature -LiteralPath $target.path
    $sameSigner = $null -ne $verified.SignerCertificate -and $verified.SignerCertificate.Thumbprint -eq $normalizedThumbprint
    $passed = $verified.Status -eq "Valid" -and $null -ne $verified.TimeStamperCertificate -and $sameSigner
    [void]$artifactResults.Add([pscustomobject]@{
      id = $target.id
      passed = $passed
      authenticodeStatus = $verified.Status.ToString()
      timestamped = $null -ne $verified.TimeStamperCertificate
      selectedSigner = $sameSigner
      sha256 = (Get-FileHash -LiteralPath $target.path -Algorithm SHA256).Hash.ToLowerInvariant()
      fileDigestAlgorithm = "SHA256"
      timestampProtocol = "RFC3161"
      timestampDigestAlgorithm = "SHA256"
    })
  }
  if (@($artifactResults | Where-Object { -not $_.passed }).Count -gt 0) {
    throw "승격 후 Windows 서명 검증에 실패했습니다."
  }

  Add-Check $checks "signing-transaction-atomic-promotion" $true @{ signedArtifacts = $stagedTargets.Count; sourceFiles = $sourcePackageTargets.Count; invalidatedReports = $invalidatedReportTargets.Count; promoted = $promotedCount; rollbackPrepared = $true }
  Write-SafeReport "verification-pending" $checks $artifactResults
  & $resolvedNode $independentAuditScript
  if ($LASTEXITCODE -ne 0) { throw "독립 Windows 코드 서명 감사에 실패했습니다." }

  Write-SafeReport "passed" $checks $artifactResults
  Write-Host "JARVIS Windows release signing passed."
} catch {
  $failure = $_
  if ($promotionStarted) {
    $promotedItems = @($promotions | Select-Object -First $promotedCount)
    [array]::Reverse($promotedItems)
    foreach ($promotion in $promotedItems) {
      try {
        if ($promotion.destinationExisted) {
          Invoke-AtomicFileReplacement $promotion.backup $promotion.destination "rollback-$transactionId"
        } else {
          Remove-PromotedDestination $promotion.destination
        }
      } catch {
        $rollbackSucceeded = $false
      }
    }
    & $resolvedNode $independentAuditScript *> $null
  }
  Add-Check $checks "signing-transaction-atomic-promotion" $false @{ promotionStarted = $promotionStarted; rollbackSucceeded = $rollbackSucceeded; preparedCount = $promotions.Count; promotedCount = $promotedCount }
  $failureStatus = if ($promotionStarted -and $rollbackSucceeded) { "failed-rolled-back" } elseif ($promotionStarted) { "failed-rollback-required" } else { "failed-no-promotion" }
  Write-SafeReport $failureStatus $checks $artifactResults
  throw $failure
} finally {
  try {
    $resolvedStageRoot = [IO.Path]::GetFullPath($stageRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedStageRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStageRoot).StartsWith("jarvis-release-signing-")) {
      Remove-Item -LiteralPath $resolvedStageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch { }
}
