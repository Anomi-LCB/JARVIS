[CmdletBinding()]
param(
  [string]$PackageDirectory = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$windowsPowerShellModulePaths = @(
  (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "WindowsPowerShell\Modules"),
  (Join-Path $env:ProgramFiles "WindowsPowerShell\Modules"),
  (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\Modules")
)
$inheritedModulePaths = @($env:PSModulePath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$env:PSModulePath = @(($windowsPowerShellModulePaths + $inheritedModulePaths) | Select-Object -Unique) -join ";"
if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
  $PackageDirectory = Join-Path $workspaceRoot "dist\pc-agent-installer"
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $workspaceRoot "artifacts\security\pc-agent-package-tamper"
}

function Get-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-Descendant([string]$Path, [string]$Parent) {
  $fullPath = Get-FullPath $Path
  $fullParent = (Get-FullPath $Parent) + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "감사 경로가 허용된 출력 디렉터리를 벗어났습니다: $fullPath"
  }
}

function Flip-FirstByte([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 1) { throw "변조할 파일이 비어 있습니다: $Path" }
  $bytes[0] = $bytes[0] -bxor 1
  [IO.File]::WriteAllBytes($Path, $bytes)
}

$packageRoot = Get-FullPath $PackageDirectory
$outputRoot = Get-FullPath $OutputDirectory
if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
  throw "PC 에이전트 패키지 디렉터리가 없습니다: $packageRoot"
}
if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
}

$manifestPath = Join-Path $packageRoot "package-manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runtimeFiles = @(
  "JarvisPcAgentTray.exe",
  "JarvisPcAgentServiceHost.exe",
  "runtime-integrity.psd1",
  "JARVIS-PC-Agent-Setup.exe"
)
$copyNames = @($manifest.files) + $runtimeFiles | Select-Object -Unique
foreach ($name in $copyNames) {
  $source = Join-Path $packageRoot $name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "감사에 필요한 패키지 파일이 없습니다: $name" }
}

$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"), $PID
$runRoot = Join-Path $outputRoot $runId
Assert-Descendant $runRoot $outputRoot
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null

$scenarios = @(
  [pscustomobject]@{ id = "baseline-valid"; target = $null; mutation = "none"; expectedExit = 0; expectedText = "무결성 검증을 통과했습니다" },
  [pscustomobject]@{ id = "source-file-tamper"; target = "README-install.md"; mutation = "append"; expectedExit = 1; expectedText = "파일 무결성 값이 일치하지 않습니다" },
  [pscustomobject]@{ id = "runtime-binary-tamper"; target = "JarvisPcAgentServiceHost.exe"; mutation = "flip"; expectedExit = 1; expectedText = "실행 파일 무결성 값이 일치하지 않습니다" },
  [pscustomobject]@{ id = "runtime-manifest-tamper"; target = "runtime-integrity.psd1"; mutation = "append"; expectedExit = 1; expectedText = "매니페스트 서명이 유효하지 않습니다" },
  [pscustomobject]@{ id = "setup-binary-tamper"; target = "JARVIS-PC-Agent-Setup.exe"; mutation = "flip"; expectedExit = 1; expectedText = "설치 프로그램 서명이 유효하지 않습니다" }
)

$results = @()
foreach ($scenario in $scenarios) {
  $scenarioRoot = Join-Path $runRoot $scenario.id
  Assert-Descendant $scenarioRoot $runRoot
  New-Item -ItemType Directory -Path $scenarioRoot -Force | Out-Null
  foreach ($name in $copyNames) {
    Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (Join-Path $scenarioRoot $name) -Force
  }

  if ($scenario.target) {
    $targetPath = Join-Path $scenarioRoot $scenario.target
    Assert-Descendant $targetPath $scenarioRoot
    if ($scenario.mutation -eq "append") {
      [IO.File]::AppendAllText($targetPath, "`r`n# JARVIS tamper audit marker", [Text.Encoding]::UTF8)
    } elseif ($scenario.mutation -eq "flip") {
      Flip-FirstByte $targetPath
    } else {
      throw "지원하지 않는 변조 방식입니다: $($scenario.mutation)"
    }
  }

  $stdoutPath = Join-Path $scenarioRoot "stdout.txt"
  $stderrPath = Join-Path $scenarioRoot "stderr.txt"
  $verifyScript = Join-Path $scenarioRoot "verify-package.ps1"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$verifyScript`""
  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $combined = ((Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue)).Trim()
  $exitMatches = $process.ExitCode -eq $scenario.expectedExit
  $messageMatches = $combined -like ("*" + $scenario.expectedText + "*")
  $results += [pscustomobject]@{
    id = $scenario.id
    status = $(if ($exitMatches -and $messageMatches) { "pass" } else { "fail" })
    expectedExit = $scenario.expectedExit
    actualExit = $process.ExitCode
    expectedTextObserved = $messageMatches
    outputTail = $(if ($combined.Length -gt 600) { $combined.Substring($combined.Length - 600) } else { $combined })
  }
}

$failed = @($results | Where-Object { $_.status -ne "pass" })
$report = [pscustomobject]@{
  schema = "jarvis-pc-agent-package-tamper-audit-v1"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  status = $(if ($failed.Count -eq 0) { "passed" } else { "failed" })
  packageDirectory = $packageRoot
  scenarioCount = $results.Count
  passedCount = @($results | Where-Object { $_.status -eq "pass" }).Count
  results = $results
  privacy = [pscustomobject]@{
    rawSecretsIncluded = $false
    certificateThumbprintsIncluded = $false
    privateKeyMaterialIncluded = $false
  }
}
$reportPath = Join-Path $runRoot "report.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "PC 에이전트 패키지 변조 감사를 저장했습니다: $reportPath"
if ($failed.Count -gt 0) { exit 1 }
