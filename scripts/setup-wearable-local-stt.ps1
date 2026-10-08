#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3', 'turbo')]
  [string]$Model = 'small',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime\wearable-stt'
$cacheDir = Join-Path $root '.runtime\wearable-stt-models'
$python = Join-Path $runtimeDir 'Scripts\python.exe'
$requirements = Join-Path $PSScriptRoot 'wearable-stt-requirements.txt'
$runner = Join-Path $PSScriptRoot 'wearable-local-stt.py'

if (-not (Test-Path -LiteralPath $python)) {
  $uv = (Get-Command uv -ErrorAction Stop).Source
  & $uv venv --python 3.13 $runtimeDir
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the wearable STT runtime.' }
}

if (-not $SkipInstall) {
  $uv = (Get-Command uv -ErrorAction Stop).Source
  & $uv pip install --python $python --requirement $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Failed to install the wearable STT dependencies.' }
}

$prefetch = & $python $runner --prefetch --model $Model --cache-dir $cacheDir
if ($LASTEXITCODE -ne 0) { throw 'Failed to prefetch the wearable STT model.' }
$prefetchResult = $prefetch | ConvertFrom-Json
if ($prefetchResult.status -ne 'ready') { throw 'Wearable STT model readiness was not confirmed.' }

$packageVersion = & $python -c "import importlib.metadata; print(importlib.metadata.version('faster-whisper'))"
$report = [ordered]@{
  reportVersion = 'c-d-wearable-local-stt-setup-v1'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  status = 'passed'
  provider = 'faster-whisper'
  packageVersion = [string]$packageVersion
  model = $Model
  computeType = 'int8'
  runtime = 'isolated-python-venv'
  privacy = [ordered]@{
    rawAudioStored = $false
    rawTranscriptLogged = $false
    cloudAudioTransfer = $false
  }
}
$distDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$reportPath = Join-Path $distDir 'wearable-local-stt-setup.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "Wearable local STT ready: $Model / int8"
Write-Host "Wrote $reportPath"
